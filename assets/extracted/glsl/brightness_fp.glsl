uniform sampler2D u_Texture0; 
varying vec2 texture_coordinate;

void main()
{
	
    gl_FragColor = texture2D(u_Texture0, texture_coordinate); 
    gl_FragColor *= 2;


	// TODO: Tie this in with the renderer
	// provide alternative brightness control by r_glsl_brightness

}	