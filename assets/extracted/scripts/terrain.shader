textures/castle/terrain_0
{
	q3map_lightmapaxis z
	q3map_texturesize 512 512
	q3map_shadeangle 120
	q3map_tcGen ivector ( 128 0 0 ) ( 0 128 0 )

	{
		map textures/organics/pjrock7d.jpg
		blendFunc GL_DST_COLOR GL_ZERO
	}
	{
		map textures/skies/clouds.tga
		blendfunc filter
		tcmod scale .2 .2
		tcMod scroll -0.15 0.15
	}
	{
		map $lightmap
		rgbGen identity
	}

	q3map_styleMarker
}

textures/castle/terrain_1
{
	q3map_lightmapaxis z
	q3map_texturesize 512 512
	q3map_shadeangle 120
	q3map_tcGen ivector ( 128 0 0 ) ( 0 128 0 )

	{
		map textures/clown/vegetation.tga
		blendFunc GL_DST_COLOR GL_ZERO
	}
	{
		map textures/skies/clouds.tga
		blendfunc filter
		tcmod scale .2 .2
		tcMod scroll -0.15 0.15
	}
	{
		map $lightmap
		rgbGen identity
	}

	q3map_styleMarker

}

textures/castle/terrain_2
{
	q3map_lightmapaxis z
	q3map_texturesize 512 512
	q3map_shadeangle 120
	q3map_tcGen ivector ( 128 0 0 ) ( 0 128 0 )

	{
		map textures/organics/pjrock7d.jpg
		blendFunc GL_DST_COLOR GL_ZERO
	}
	{
		map textures/skies/clouds.tga
		blendfunc filter
		tcmod scale .2 .2
		tcMod scroll -0.15 0.15
	}
	{
		map $lightmap
		rgbGen identity
	}

	q3map_styleMarker

}

textures/castle/terrain_0to1
{
	q3map_lightmapaxis z
	q3map_texturesize 512 512
	q3map_shadeangle 120
	q3map_tcGen ivector ( 128 0 0 ) ( 0 128 0 )

	{
		map textures/organics/pjrock7d.jpg
		blendFunc GL_DST_COLOR GL_ZERO
	}
	{
		map textures/clown/vegetation.tga
		alphaGen vertex
		blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA
	}
	{
		map textures/skies/clouds.tga
		blendfunc filter
		tcmod scale .2 .2
		tcMod scroll -0.15 0.15
	}
	{
		map $lightmap
		rgbGen identity
	}

	q3map_styleMarker

}

textures/castle/terrain_0to2
{
	q3map_lightmapaxis z
	q3map_texturesize 512 512
	q3map_shadeangle 120
	q3map_tcGen ivector ( 128 0 0 ) ( 0 128 0 )

	{
		map textures/organics/pjrock7d.jpg
		blendFunc GL_DST_COLOR GL_ZERO
	}
	{
		map textures/organics/pjrock7d.jpg
		alphaGen vertex
		blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA
	}
	{
		map textures/skies/clouds.tga
		blendfunc filter
		tcmod scale .2 .2
		tcMod scroll -0.15 0.15
	}
	{
		map $lightmap
		rgbGen identity
	}

	q3map_styleMarker

}

textures/castle/terrain_1to2
{
	q3map_lightmapaxis z
	q3map_texturesize 512 512
	q3map_shadeangle 120
	q3map_tcGen ivector ( 128 0 0 ) ( 0 128 0 )

	{
		map textures/clown/vegetation.tga
		blendFunc GL_DST_COLOR GL_ZERO
	}
	{
		map textures/organics/pjrock7d.jpg
		alphaGen vertex
		blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA
	}
	{
		map textures/skies/clouds.tga
		blendfunc filter
		tcmod scale .2 .2
		tcMod scroll -0.15 0.15
	}
	{
		map $lightmap
		rgbGen identity
	}

	q3map_styleMarker

}

textures/castle/terrain.vertex
{
	{
		map textures/organics/pjrock7d.jpg
		rgbGen vertex
	}
}

textures/castle/ter_rock-mud
{
       	q3map_nonplanar
	q3map_shadeangle 180
	q3map_tcGen ivector ( 256 0 0 ) ( 0 256 0 )
	q3map_alphaMod dotproduct2 ( 0.0 0.0 0.95 )



	{
		map textures/organics/pjrock7d.jpg	// Primary
		rgbGen identity
	}

	{
 		map textures/clown/vegetation.tga	// Secondary
		blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA
		alphaFunc GE128
		rgbGen identity
		alphaGen vertex
	}
	{
		map textures/skies/clouds.tga
		blendfunc filter
		tcmod scale .2 .2
		tcMod scroll -0.15 0.15
	}
	{
		map $lightmap
		rgbGen identity
		blendFunc GL_DST_COLOR GL_ZERO
	}
	q3map_styleMarker

}