//12-12-06 removed redundant nodrop
//12-23-06 fixed the b0rked invisible shader
//01-25-07 removed redundant clip + added nodrawnonsolid, clusterportal
//01-27-07 moved portal from clown.shader to here
//01-31-07 added mirror shader doesnt work, gave other shaders transparency in map editor.-kit89 
//02-14-07 added timportal + mirror1, mirror 2, terrain, terrain 2, metalclip 
//02-27-07 added botclip, missleclip, remapped certain mirrors to point to invisible.tga
//need this or maps FTBFS
//for the idiot bots out there use instead of botclip!!!!
textures/common/donotenter
{
	surfaceparm nodraw
	surfaceparm nonsolid
	surfaceparm trans
	surfaceparm nomarks
	surfaceparm donotenter
}

textures/common/clip
{
	surfaceparm nolightmap
	surfaceparm nomarks
	surfaceparm nodraw
	surfaceparm nonsolid
	surfaceparm playerclip
	surfaceparm noimpact
}

textures/common/caulk
{
	surfaceparm nodraw
	surfaceparm nomarks
        surfaceparm nolightmap
}

textures/common/invisible
{
	surfaceparm nolightmap			
                        
        {
		map textures/common/invisible.tga
		alphaFunc GE128
		depthWrite
		rgbGen vertex
	}
        
}

//use this near the trigger hurts, lava, death fogs, etc.
// to keep weapons and powerups from piling up...
textures/common/nodrop
{
	surfaceparm 	trans
	surfaceparm	nonsolid
	surfaceparm	nomarks
	surfaceparm     nodrop
	surfaceparm 	nolightmap
	surfaceparm 	nodraw
	cull		none
}
//need this for the teleporters in cbctf1
textures/common/trigger
{
	surfaceparm nodraw
	
}
//also needed for for cbctf1
textures/common/origin
{
	surfaceparm nodraw
	surfaceparm nonsolid
	surfaceparm origin
}
//aids in VIS compiles
textures/common/hint
{
	surfaceparm hint
	surfaceparm nodraw
	surfaceparm nonsolid
	surfaceparm structural
	surfaceparm trans
	surfaceparm noimpact
}

textures/common/nodraw
{
	surfaceparm nodraw
	surfaceparm nonsolid
	surfaceparm nomarks
	surfaceparm trans
}
//for an icy effect
textures/common/slick
{
	surfaceparm nodraw
	surfaceparm nomarks
	surfaceparm trans
	surfaceparm slick
}

textures/common/cushion
{
	surfaceparm nodraw
	surfaceparm nomarks
	surfaceparm nodamage
	surfaceparm trans
}

//to keep certain textures from being shot up
textures/common/weapclip
{
	surfaceparm nodraw
	surfaceparm trans
	surfaceparm nomarks
}

//for every stupid q3dm17 remake
textures/common/nodrawnonsolid
{
	surfaceparm	nonsolid
	surfaceparm	nodraw
}

//hint for the bots
textures/common/clusterportal
{
	qer_nocarve
	surfaceparm nodraw
	surfaceparm nonsolid
	surfaceparm trans
	surfaceparm nomarks
	surfaceparm clusterportal
}

//can also be used as a mirror
textures/common/portal
{
	qer_editorimage textures/common/invisible.tga
	surfaceparm nolightmap
	portal
	{
		map textures/common/invisible.tga
		blendfunc GL_ONE GL_ONE_MINUS_SRC_ALPHA
		depthWrite

	}
}

//Added for Mirrors
textures/common/mirror
{
	portal
	q3map_nolightmap
    {
        map textures/common/invisible.tga
        blendFunc GL_ONE GL_ONE_MINUS_SRC_ALPHA
        depthWrite
    }
}

textures/common/timportal
{
	qer_editorimage textures/common/invisible.tga
	surfaceparm nolightmap
	portal
	{
		map textures/common/invisible.tga
		blendfunc GL_ONE GL_ONE_MINUS_SRC_ALPHA
		depthWrite

	}
	{
		map textures/oa_fogs/kc_fogcloud3.jpg
		blendfunc gl_src_alpha gl_one_minus_src_alpha
		alphagen portal 512
		rgbGen identity	
		tcmod rotate .1 
		tcmod scroll .04 .01
	}
}

//nicked from nexuiz for backwards compat 
textures/common/mirror1
{
	qer_editorimage textures/common/invisible.tga
	surfaceparm nolightmap
	portal
  
	{
		map textures/common/invisible.tga
		blendfunc GL_ONE GL_ONE_MINUS_SRC_ALPHA
		depthWrite
	}
       
        

}

//nicked from nexuiz w/added turb. for backwards compat 
textures/common/mirror2
{
	qer_editorimage textures/common/invisible.tga
	surfaceparm nolightmap
	portal
	{
		map textures/common/invisible.tga
		blendfunc GL_ONE GL_ONE_MINUS_SRC_ALPHA
		depthWrite
	}
        {
               map textures/sfx/mirror.tga
	       tcMod turb 0 0.25 0 0.05
	       blendFunc GL_ZERO GL_ONE_MINUS_SRC_COLOR
        }

}

//nicked from nexuiz
textures/common/terrain
{
	q3map_terrain
	surfaceparm nodraw
        surfaceparm nolightmap
	surfaceparm nomarks
}

//nicked from nexuiz
textures/common/terrain2
{
	q3map_terrain
	qer_editorimage textures/common/common.tga
	surfaceparm dust
	surfaceparm nodraw
	surfaceparm nomarks
	surfaceparm nolightmap
}

//nicked from nexuiz
textures/common/metalclip
{
	surfaceparm nodraw
	surfaceparm nolightmap
	surfaceparm nonsolid
	surfaceparm trans
	surfaceparm nomarks
	surfaceparm noimpact
	surfaceparm playerclip
	surfaceparm metalsteps
}

// acts as player clip only for the bots
// can keep them from being pushed into voids
// do not use, use donotenter instead :-P
textures/common/botclip
{
	surfaceparm nodraw
	surfaceparm nolightmap
	surfaceparm nonsolid
	surfaceparm trans
	surfaceparm nomarks
	surfaceparm noimpact
	surfaceparm botclip
}

textures/common/missileclip
{
	surfaceparm nodamage
	surfaceparm nomarks
	surfaceparm nodraw
	surfaceparm playerclip
	surfaceparm trans
}

textures/common/full_clip
{
	surfaceparm nodraw
	surfaceparm playerclip
}

textures/common/antiportal
{
	qer_nocarve
	surfaceparm nodraw
	surfaceparm nonsolid
	surfaceparm structural
	surfaceparm trans
	surfaceparm antiportal
}

textures/common/areaportal
{
	surfaceparm nodraw
	surfaceparm nolightmap
	surfaceparm nonsolid
	surfaceparm structural
	surfaceparm trans
	surfaceparm nomarks
	surfaceparm areaportal
}

textures/common/lightgrid
{
	surfaceparm nodraw
	surfaceparm nolightmap
	surfaceparm nonsolid
	surfaceparm detail
	surfaceparm nomarks
	surfaceparm trans
	surfaceparm lightgrid
}
